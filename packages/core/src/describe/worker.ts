// Headless describer worker (spec section 16, recipe confirmed in M0 on Claude Code CLI 2.1.325): runs
// `claude -p` with no tools, no MCP servers and a JSON schema, feeds it fact sheets and stores what passes
// `validateDescription`. Everything that goes wrong (not logged in, crash, timeout, bad output) ends with the
// functions back in the backlog; nothing here throws for a worker problem.
import { type ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { GantryConfig, TaskName } from "../config/index.js";
import { isSensitive } from "../discover/index.js";
import type { Store } from "../store/index.js";
import type { FactSheet } from "../types.js";
import { BATCH_SIZE, backlogPriority } from "./backlog.js";
import { routeFor } from "./route.js";
import { BATCH_RESULT_JSON_SCHEMA } from "./schema.js";
import { storeDescriptions } from "./store.js";
import { logUsage } from "./usage.js";
import { validateDescription } from "./validate.js";

export interface WorkerResult {
  described: number;
  failed: number;
  queued: number;
  inputTokens: number;
  outputTokens: number;
  ms: number;
}

export interface WorkerOptions {
  task: TaskName;
  /** Milliseconds from the start of the call after which the child is killed and the rest is queued. `Infinity` = none. */
  deadlineMs: number;
  config: GantryConfig;
  /** Environment of the child (default `process.env`); `GANTRY_WORKER=1` is always set and the effort override removed. */
  env?: NodeJS.ProcessEnv;
  /** Fixed batch size (at most 40). Default: sized from the time left (`batchSizeFor`). */
  batchSize?: number;
}

/** Measured in M0 (Haiku/low, spec section 16): cold start of one call and the cost of each extra function. */
export const COLD_START_MS = 3300;
export const MS_PER_FUNCTION = 400;
const AUTH_CACHE_MS = 10 * 60 * 1000;
const AUTH_TIMEOUT_MS = 10_000;
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const KILL_GRACE_MS = 150;
/** A failed row is retried once on the retry route; at this many attempts it stays failed. */
export const MAX_ATTEMPTS = 2;

/**
 * How many functions fit one call in the time left, from the M0 numbers (about 3.3 s cold start, 0.4 s per
 * function): 8 s allows about 11. At most 40 (the spec batch size); 0 means "not worth starting a call".
 */
export function batchSizeFor(remainingMs: number): number {
  if (!Number.isFinite(remainingMs)) return BATCH_SIZE;
  return Math.max(0, Math.min(BATCH_SIZE, Math.floor((remainingMs - COLD_START_MS) / MS_PER_FUNCTION)));
}

/** Binary order (spec section 16): config override, then `$CLAUDE_CODE_EXECPATH`, then `claude` on `PATH`. */
export function resolveClaudeBinary(config: GantryConfig, env: NodeJS.ProcessEnv = process.env): string {
  const override = config.worker?.binary;
  if (override !== undefined && override !== "") return override;
  const exec = env.CLAUDE_CODE_EXECPATH;
  if (exec !== undefined && exec !== "") return exec;
  return "claude";
}

/** The child's environment: `GANTRY_WORKER=1` (hooks and recursion guard) and no `CLAUDE_CODE_EFFORT_LEVEL`, which would override `--effort`. */
export function workerEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base, GANTRY_WORKER: "1" };
  delete env.CLAUDE_CODE_EFFORT_LEVEL;
  return env;
}

/**
 * The system prompt file: `prompts/p1.md` next to this module (same relative path in the source tree and in the
 * bundle, where `tsup.config.ts` copies it to `plugin/dist/prompts/`), else the source copy when running from
 * the `tsc -b` output (`packages/core/dist/describe/`).
 */
export function promptFile(): string {
  const beside = fileURLToPath(new URL("./prompts/p1.md", import.meta.url));
  if (fs.existsSync(beside)) return beside;
  const source = fileURLToPath(new URL("../../src/describe/prompts/p1.md", import.meta.url));
  return fs.existsSync(source) ? source : beside;
}

/** The exact argument list of the section 16 recipe. */
export function workerArgs(model: string, effort: string, systemPromptFile: string): string[] {
  return [
    "-p",
    "--model",
    model,
    "--effort",
    effort,
    "--safe-mode",
    "--tools",
    "",
    "--disallowedTools",
    "mcp__*",
    "--strict-mcp-config",
    "--system-prompt-file",
    systemPromptFile,
    "--no-session-persistence",
    "--output-format",
    "json",
    "--json-schema",
    JSON.stringify(BATCH_RESULT_JSON_SCHEMA),
  ];
}

function nameOfId(id: string): string {
  const hash = id.indexOf("#");
  return hash < 0 ? id : id.slice(hash + 1).replace(/~\d+$/, "");
}

/** stdin of the worker: one block per fact sheet, headed by the line the system prompt refers to. */
export function renderFactSheets(sheets: FactSheet[]): string {
  return `${sheets
    .map((s) => {
      const lines = [
        `=== FACT SHEET ${s.contentKey} ===`,
        `kind: ${s.kind}`,
        `name: ${nameOfId(s.id)}`,
        `path: ${s.path}`,
        `signature: ${s.signature}`,
      ];
      if (s.doc) lines.push(`doc: ${s.doc}`);
      if (s.callees.length > 0) lines.push(`callees: ${s.callees.join(", ")}`);
      if (s.returnType) lines.push(`returns: ${s.returnType}`);
      lines.push("body:", s.body);
      return lines.join("\n");
    })
    .join("\n\n")}\n`;
}

interface ChildResult {
  stdout: string;
  stderr: string;
  code: number | null;
  timedOut: boolean;
  spawnError: boolean;
}

/** Runs a child in its own process group; at `timeoutMs` the whole group is killed with SIGKILL. */
function runChild(
  bin: string,
  args: string[],
  input: string,
  o: { env: NodeJS.ProcessEnv; cwd: string; timeoutMs: number },
): Promise<ChildResult> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(bin, args, { cwd: o.cwd, env: o.env, detached: true, stdio: ["pipe", "pipe", "pipe"] });
    } catch {
      resolve({ stdout: "", stderr: "", code: null, timedOut: false, spawnError: true });
      return;
    }
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let size = 0;
    let timedOut = false;
    let done = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (code: number | null, spawnError = false): void => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      resolve({
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
        code,
        timedOut,
        spawnError,
      });
    };
    const killGroup = (): void => {
      const pid = child.pid;
      try {
        if (pid !== undefined) process.kill(-pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        try {
          child.kill("SIGKILL");
        } catch {
          // already gone
        }
      }
    };
    const collect = (into: Buffer[]) => (b: Buffer) => {
      size += b.length;
      if (size > MAX_OUTPUT_BYTES) {
        killGroup();
        return;
      }
      into.push(b);
    };
    child.stdout?.on("data", collect(out));
    child.stderr?.on("data", collect(err));
    child.on("error", () => finish(null, true));
    child.on("close", (code) => finish(code));
    child.stdin?.on("error", () => {});
    child.stdin?.end(input);
    if (Number.isFinite(o.timeoutMs)) {
      timer = setTimeout(
        () => {
          timedOut = true;
          killGroup();
          // A grandchild may still hold the pipes open; do not wait for them.
          setTimeout(() => finish(null), KILL_GRACE_MS).unref();
        },
        Math.max(0, o.timeoutMs),
      );
    }
  });
}

interface AuthCache {
  at: number;
  bin: string;
  loggedIn: boolean;
}

/** `claude auth status` must report `loggedIn === true`; the answer is cached in `meta` for 10 minutes. */
async function isLoggedIn(
  store: Store,
  bin: string,
  env: NodeJS.ProcessEnv,
  cwd: string,
  remainingMs: number,
): Promise<boolean> {
  try {
    const raw = store.getMeta("worker_auth");
    if (raw) {
      const c = JSON.parse(raw) as AuthCache;
      if (c.bin === bin && typeof c.at === "number" && Date.now() - c.at < AUTH_CACHE_MS) return c.loggedIn;
    }
  } catch {
    // a bad cache entry is ignored
  }
  const r = await runChild(bin, ["auth", "status"], "", {
    env,
    cwd,
    timeoutMs: Math.min(remainingMs, AUTH_TIMEOUT_MS),
  });
  if (r.spawnError || r.timedOut) return false;
  let loggedIn = false;
  try {
    loggedIn = (JSON.parse(r.stdout) as { loggedIn?: unknown }).loggedIn === true;
  } catch {
    return false; // unreadable answer: no worker this time, and nothing cached
  }
  try {
    store.setMeta("worker_auth", JSON.stringify({ at: Date.now(), bin, loggedIn } satisfies AuthCache));
  } catch {
    // caching is best effort
  }
  return loggedIn;
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

interface CallOutcome {
  /** Parsed `structured_output.results`, when the call produced it. */
  results?: unknown[];
  inputTokens: number;
  outputTokens: number;
}

function parseCall(stdout: string): CallOutcome {
  const none: CallOutcome = { inputTokens: 0, outputTokens: 0 };
  let j: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(stdout.trim());
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return none;
    j = parsed as Record<string, unknown>;
  } catch {
    return none;
  }
  const u = (typeof j.usage === "object" && j.usage !== null ? j.usage : {}) as Record<string, unknown>;
  // Input counts cache creation and reads, like the M0 estimate (950 tokens per function "including cache").
  const outcome: CallOutcome = {
    inputTokens: num(u.input_tokens) + num(u.cache_creation_input_tokens) + num(u.cache_read_input_tokens),
    outputTokens: num(u.output_tokens),
  };
  if (j.is_error === true) return outcome;
  const so = j.structured_output;
  if (typeof so === "object" && so !== null && Array.isArray((so as { results?: unknown }).results)) {
    outcome.results = (so as { results: unknown[] }).results;
  }
  return outcome;
}

function backlogRow(store: Store, key: string): { status: string; attempts: number } | undefined {
  return store.db.prepare("SELECT status, attempts FROM backlog WHERE content_key = ?").get(key) as
    | { status: string; attempts: number }
    | undefined;
}

/** Makes sure a `pending` row exists for the sheet (a sheet from pre-commit already has one). */
function ensureQueued(store: Store, sheet: FactSheet): void {
  if (backlogRow(store, sheet.contentKey)) return;
  const sym = store.getSymbol(sheet.id);
  const priority = sym ? backlogPriority(sym.kind, sym.exported, sheet.path) : 2;
  store.db
    .prepare(
      "INSERT OR IGNORE INTO backlog(content_key, symbol_id, priority, status) VALUES (?, ?, ?, 'pending')",
    )
    .run(sheet.contentKey, sheet.id, priority);
}

function markFailed(store: Store, sheet: FactSheet, why: string): void {
  ensureQueued(store, sheet);
  store.db
    .prepare(
      `UPDATE backlog SET status = 'failed', attempts = attempts + 1, last_error = ?, claimed_by = NULL, claimed_at = NULL
       WHERE content_key = ?`,
    )
    .run(why.slice(0, 200), sheet.contentKey);
}

/**
 * Describes `sheets` with the headless worker on the route of `opts.task` and stores what passes
 * `validateDescription`. Accepted descriptions are stored, invalid or missing ones get backlog status `failed`
 * (attempts + 1), everything not attempted (not logged in, crash, no structured output, deadline) stays `pending`.
 * One `usage_log` row per call. Never throws for a worker problem.
 */
export async function describeWithWorker(
  store: Store,
  sheets: FactSheet[],
  opts: WorkerOptions,
): Promise<WorkerResult> {
  const t0 = Date.now();
  const deadlineAt = t0 + opts.deadlineMs;
  const result: WorkerResult = { described: 0, failed: 0, queued: 0, inputTokens: 0, outputTokens: 0, ms: 0 };
  const finish = (): WorkerResult => {
    result.ms = Date.now() - t0;
    return result;
  };

  // buildFactSheet already refuses sensitive paths; assert it again where the data leaves the process.
  const todo = sheets.filter((s) => !isSensitive(s.path));
  for (const s of todo) ensureQueued(store, s);
  if (todo.length === 0) return finish();
  const queueRest = (rest: FactSheet[]): void => {
    result.queued += rest.length;
  };

  const route = routeFor(opts.task, opts.config);
  const env = workerEnv(opts.env ?? process.env);
  const bin = resolveClaudeBinary(opts.config, opts.env ?? process.env);
  let cwd: string | undefined;
  try {
    if (deadlineAt - Date.now() <= 0) {
      queueRest(todo);
      return finish();
    }
    // The child never runs inside the target repo: a throwaway directory is its working directory.
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), "gantry-worker-"));
    const prompt = promptFile();
    if (!fs.existsSync(prompt)) {
      queueRest(todo);
      return finish();
    }
    if (!(await isLoggedIn(store, bin, env, cwd, deadlineAt - Date.now()))) {
      queueRest(todo);
      return finish();
    }

    let next = 0;
    while (next < todo.length) {
      const remaining = deadlineAt - Date.now();
      const size = Math.min(opts.batchSize ?? batchSizeFor(remaining), BATCH_SIZE);
      if (remaining <= 0 || size < 1) break;
      const batch = todo.slice(next, next + size);
      next += batch.length;

      const run = await runChild(
        bin,
        workerArgs(route.model, route.effort, prompt),
        renderFactSheets(batch),
        {
          env,
          cwd,
          timeoutMs: remaining,
        },
      );
      const call =
        run.timedOut || run.spawnError ? { inputTokens: 0, outputTokens: 0 } : parseCall(run.stdout);
      const hadTokens = call.inputTokens > 0 || call.outputTokens > 0;
      result.inputTokens += call.inputTokens;
      result.outputTokens += call.outputTokens;
      try {
        logUsage(store, {
          task: opts.task,
          model: route.model,
          effort: route.effort,
          functions: batch.length,
          ...(hadTokens ? { inputTokens: call.inputTokens, outputTokens: call.outputTokens } : {}),
          source: "worker",
        });
      } catch {
        // usage logging must not lose the descriptions
      }

      if (call.results === undefined) {
        // Killed at the deadline, crashed, or no structured_output: the whole batch stays queued.
        queueRest(batch);
        if (run.timedOut) break;
        continue;
      }

      const byKey = new Map<string, unknown>();
      for (const r of call.results) {
        if (typeof r !== "object" || r === null) continue;
        const key = (r as { content_key?: unknown }).content_key;
        if (typeof key === "string" && !byKey.has(key))
          byKey.set(key, (r as { description?: unknown }).description);
      }
      const accepted: Parameters<typeof storeDescriptions>[1] = [];
      for (const sheet of batch) {
        if (!byKey.has(sheet.contentKey)) {
          markFailed(store, sheet, "missing from worker output");
          result.failed++;
          continue;
        }
        const v = validateDescription(byKey.get(sheet.contentKey), sheet);
        if (v.ok) {
          accepted.push({
            contentKey: sheet.contentKey,
            description: v.value,
            model: route.model,
            provenance: "worker",
          });
        } else {
          markFailed(store, sheet, `${v.reason}: ${v.detail}`);
          result.failed++;
        }
      }
      result.described += storeDescriptions(store, accepted);
      if (run.timedOut) break;
    }
    queueRest(todo.slice(next));
  } catch {
    // Anything unexpected: what was not finished stays in the backlog, already counted below.
    result.queued = Math.max(result.queued, todo.length - result.described - result.failed);
  } finally {
    if (cwd) fs.rmSync(cwd, { recursive: true, force: true });
  }
  return finish();
}

/**
 * The pre-commit describer: sheets whose backlog row is not yet `failed` run on `opts.task`; rows already
 * `failed` once (attempts below `MAX_ATTEMPTS`), and the ones that fail in the first pass, run once on
 * `describe.retry` (Sonnet by default) when time is left. A row that fails twice stays `failed`.
 */
export async function describeWithRetry(
  store: Store,
  sheets: FactSheet[],
  opts: WorkerOptions,
): Promise<WorkerResult> {
  const t0 = Date.now();
  const left = (): number => opts.deadlineMs - (Date.now() - t0);
  const fresh: FactSheet[] = [];
  const retry: FactSheet[] = [];
  for (const s of sheets) {
    const row = backlogRow(store, s.contentKey);
    if (row?.status === "failed") {
      if (row.attempts < MAX_ATTEMPTS) retry.push(s);
    } else fresh.push(s);
  }
  const first = await describeWithWorker(store, fresh, opts);
  const total: WorkerResult = { ...first };
  const failedNow = fresh.filter((s) => backlogRow(store, s.contentKey)?.status === "failed");
  const second = [
    ...retry,
    ...failedNow.filter((s) => (backlogRow(store, s.contentKey)?.attempts ?? 0) < MAX_ATTEMPTS),
  ];
  if (second.length > 0) {
    // The first pass counted its failures; they move into the retry pass's own tally.
    total.failed -= failedNow.length;
    if (left() > 0) {
      const r = await describeWithWorker(store, second, {
        ...opts,
        task: "describe.retry",
        deadlineMs: left(),
      });
      total.described += r.described;
      total.failed += r.failed;
      total.queued += r.queued;
      total.inputTokens += r.inputTokens;
      total.outputTokens += r.outputTokens;
    } else {
      total.failed += failedNow.length;
      total.queued += retry.length;
    }
  }
  total.ms = Date.now() - t0;
  return total;
}

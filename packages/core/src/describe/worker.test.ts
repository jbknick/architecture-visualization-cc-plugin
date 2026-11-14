import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type GantryConfig, loadConfig } from "../config/index.js";
import type { Store } from "../store/index.js";
import type { FactSheet } from "../types.js";
import { claimBatch, syncBacklog } from "./backlog.js";
import { buildFactSheet, FUNCTION_LIKE_KINDS } from "./factsheet.js";
import { routeFor } from "./route.js";
import { MAX_DESCRIBE_ATTEMPTS } from "./store.js";
import { submitDescriptions } from "./submit.js";
import { cleanupData, type Indexed, indexedFixture } from "./testkit.js";
import { estimateCostUsd, logUsage, PRICE_PER_MTOK } from "./usage.js";
import {
  batchSizeFor,
  COLD_START_MS,
  describeWithRetry,
  describeWithWorker,
  promptFile,
  renderFactSheets,
  resolveClaudeBinary,
  workerArgs,
  workerEnv,
} from "./worker.js";

interface FakeClaude {
  bin: string;
  configure(patch: Record<string, unknown>): void;
  calls(): {
    kind: string;
    argv: string[];
    cwd: string;
    gantryWorker: string | null;
    effortLevelSet: boolean;
    keys: string[];
    model: string | null;
    effort: string | null;
    systemPromptFile: string | null;
  }[];
  runCalls(): ReturnType<FakeClaude["calls"]>;
  grandchildPid(): number | undefined;
}
const helperPath = "../../test/helpers/fakeClaude.js";
const { writeFakeClaude } = (await import(/* @vite-ignore */ helperPath)) as {
  writeFakeClaude: (dir: string, initial?: Record<string, unknown>) => FakeClaude;
};

/** Six multi-statement functions on top of the fixture, so there are enough sheets for batch tests. */
const EXTRA = {
  "src/extra.ts": Array.from(
    { length: 6 },
    (_, i) =>
      `export function extra${i}(n: number) {\n  const a = n + ${i};\n  const b = a * 2;\n  return b - ${i};\n}\n`,
  ).join("\n"),
};

let ix: Indexed;
let fake: FakeClaude;
let fakeDir: string;
let config: GantryConfig;
let sheets: FactSheet[];
const SAVED = process.env.CLAUDE_CODE_EFFORT_LEVEL;

beforeEach(async () => {
  ix = await indexedFixture("single-pkg", EXTRA);
  fakeDir = mkdtempSync(join(tmpdir(), "gantry-fake-claude-"));
  fake = writeFakeClaude(fakeDir);
  config = { ...loadConfig(ix.paths), worker: { binary: fake.bin } };
  syncBacklog(ix.store);
  sheets = sheetsOf(ix.store, ix.paths.root);
  expect(sheets.length).toBeGreaterThanOrEqual(5);
});

afterEach(async () => {
  await ix.close();
  cleanupData();
  rmSync(fakeDir, { recursive: true, force: true });
  if (SAVED === undefined) delete process.env.CLAUDE_CODE_EFFORT_LEVEL;
  else process.env.CLAUDE_CODE_EFFORT_LEVEL = SAVED;
});

/** Fact sheets of the pending backlog rows, in backlog order. */
function sheetsOf(store: Store, root: string): FactSheet[] {
  const rows = store.db
    .prepare("SELECT symbol_id FROM backlog WHERE status = 'pending' ORDER BY priority, symbol_id")
    .all() as { symbol_id: string }[];
  const out: FactSheet[] = [];
  for (const { symbol_id } of rows) {
    const sym = store.getSymbol(symbol_id);
    if (!sym || !FUNCTION_LIKE_KINDS.includes(sym.kind)) continue;
    out.push(
      buildFactSheet(store, sym.id, readFileSync(join(root, sym.fileId.replace(/^file:/, "")), "utf8")),
    );
  }
  return out;
}

const run = (list: FactSheet[], over: Record<string, unknown> = {}) =>
  describeWithWorker(ix.store, list, {
    task: "describe.precommit",
    deadlineMs: 20_000,
    config,
    env: { ...process.env },
    batchSize: 40,
    ...over,
  });
const status = (key: string) =>
  ix.store.db.prepare("SELECT status, attempts, last_error FROM backlog WHERE content_key = ?").get(key) as
    | { status: string; attempts: number; last_error: string | null }
    | undefined;
const descCount = () =>
  (
    ix.store.db.prepare("SELECT COUNT(*) AS n FROM descriptions WHERE provenance = 'model'").get() as {
      n: number;
    }
  ).n;
const usage = () =>
  ix.store.db.prepare("SELECT * FROM usage_log ORDER BY id").all() as Record<string, unknown>[];

describe("routeFor and usage plumbing", () => {
  it("reads config.routing, with the retry task on Sonnet by default", () => {
    expect(routeFor("describe.precommit", config)).toEqual({ model: "haiku", effort: "low" });
    expect(routeFor("describe.retry", config)).toEqual({ model: "sonnet", effort: "low" });
    const custom = {
      ...config,
      routing: {
        ...config.routing,
        "describe.precommit": { model: "opus" as const, effort: "high" as const },
      },
    };
    expect(routeFor("describe.precommit", custom)).toEqual({ model: "opus", effort: "high" });
  });

  it("logUsage writes a row with an estimated cost and the source", () => {
    logUsage(ix.store, {
      task: "describe.precommit",
      model: "haiku",
      effort: "low",
      functions: 3,
      inputTokens: 2_000_000,
      outputTokens: 1_000_000,
      source: "worker",
    });
    const [row] = usage();
    expect(row).toMatchObject({
      task: "describe.precommit",
      model: "haiku",
      effort: "low",
      functions: 3,
      input_tokens: 2_000_000,
      output_tokens: 1_000_000,
      source: "worker",
    });
    expect(row?.cost_estimate_usd).toBeCloseTo(
      2 * (PRICE_PER_MTOK.haiku?.input ?? 0) + (PRICE_PER_MTOK.haiku?.output ?? 0),
    );
    expect(estimateCostUsd("some-unknown-model", 10, 10)).toBe(0);
  });
});

describe("recipe pieces", () => {
  it("resolves the binary: config override, then CLAUDE_CODE_EXECPATH, then claude", () => {
    expect(
      resolveClaudeBinary(
        { ...config, worker: { binary: "/x/claude" } },
        { CLAUDE_CODE_EXECPATH: "/e/claude" },
      ),
    ).toBe("/x/claude");
    expect(resolveClaudeBinary({ ...config, worker: {} }, { CLAUDE_CODE_EXECPATH: "/e/claude" })).toBe(
      "/e/claude",
    );
    expect(resolveClaudeBinary({ ...config, worker: {} }, {})).toBe("claude");
  });

  it("sets GANTRY_WORKER=1 and removes CLAUDE_CODE_EFFORT_LEVEL from the child env", () => {
    const env = workerEnv({ A: "1", CLAUDE_CODE_EFFORT_LEVEL: "max" });
    expect(env).toMatchObject({ A: "1", GANTRY_WORKER: "1" });
    expect("CLAUDE_CODE_EFFORT_LEVEL" in env).toBe(false);
  });

  it("builds the section 16 argument list with a mandatory --json-schema", () => {
    const a = workerArgs("haiku", "low", "/p/p1.md");
    expect(a.slice(0, 3)).toEqual(["-p", "--model", "haiku"]);
    for (const f of ["--safe-mode", "--strict-mcp-config", "--no-session-persistence"])
      expect(a).toContain(f);
    expect(a[a.indexOf("--tools") + 1]).toBe("");
    expect(a[a.indexOf("--disallowedTools") + 1]).toBe("mcp__*");
    expect(a[a.indexOf("--system-prompt-file") + 1]).toBe("/p/p1.md");
    expect(a[a.indexOf("--output-format") + 1]).toBe("json");
    expect(JSON.parse(a[a.indexOf("--json-schema") + 1] as string).required).toEqual(["results"]);
    expect(existsSync(promptFile())).toBe(true);
  });

  it("sizes a call from the time left (M0: 3.3 s cold start, 0.4 s per function)", () => {
    expect(batchSizeFor(Number.POSITIVE_INFINITY)).toBe(40);
    expect(batchSizeFor(8000)).toBe(11);
    expect(batchSizeFor(COLD_START_MS)).toBe(0);
    expect(batchSizeFor(1000)).toBe(0);
    expect(batchSizeFor(60_000)).toBe(40);
  });

  it("renders one headed block per fact sheet", () => {
    const text = renderFactSheets(sheets.slice(0, 2));
    expect([...text.matchAll(/^=== FACT SHEET (\S+) ===$/gm)].map((m) => m[1])).toEqual(
      sheets.slice(0, 2).map((s) => s.contentKey),
    );
  });
});

describe("describeWithWorker", () => {
  it("runs the recipe against the fake, stores accepted descriptions and logs usage with tokens", async () => {
    process.env.CLAUDE_CODE_EFFORT_LEVEL = "max";
    const r = await run(sheets);
    expect(r).toMatchObject({
      described: sheets.length,
      failed: 0,
      queued: 0,
      inputTokens: 900,
      outputTokens: 60,
    });
    expect(descCount()).toBe(sheets.length);
    const d = ix.store.db
      .prepare("SELECT provenance, model, behavior FROM descriptions WHERE provenance = 'model' LIMIT 1")
      .get();
    expect(d).toMatchObject({
      provenance: "model",
      model: "haiku",
      behavior: "Returns the total of the given numbers.",
    });
    expect(ix.store.db.prepare("SELECT COUNT(*) AS n FROM backlog").get()).toEqual({ n: 0 });

    const [call] = fake.runCalls();
    expect(call?.argv).toEqual(workerArgs("haiku", "low", promptFile()));
    expect(call?.gantryWorker).toBe("1");
    expect(call?.effortLevelSet).toBe(false);
    expect(call?.keys).toEqual(sheets.map((s) => s.contentKey));
    expect(call?.cwd).not.toContain(ix.fx.dir);

    const rows = usage();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      task: "describe.precommit",
      model: "haiku",
      effort: "low",
      functions: sheets.length,
      input_tokens: 900,
      output_tokens: 60,
      source: "worker",
    });
    expect(rows[0]?.cost_estimate_usd).toBeGreaterThan(0);
  });

  it("repairs an over-length behavior instead of failing the function", async () => {
    fake.configure({ mode: "overlong" });
    const r = await run(sheets.slice(0, 2));
    expect(r.described).toBe(2);
    const b = (
      ix.store.db.prepare("SELECT behavior FROM descriptions WHERE provenance = 'model' LIMIT 1").get() as {
        behavior: string;
      }
    ).behavior;
    expect(b.split(/\s+/).length).toBeLessThanOrEqual(25);
  });

  it("not logged in: queues everything, runs nothing, logs nothing, and caches the answer for 10 minutes", async () => {
    fake.configure({ loggedIn: false });
    const r = await run(sheets);
    expect(r).toMatchObject({ described: 0, failed: 0, queued: sheets.length });
    await run(sheets);
    expect(fake.runCalls()).toHaveLength(0);
    expect(fake.calls().filter((c) => c.kind === "auth")).toHaveLength(1);
    expect(usage()).toHaveLength(0);
    expect(descCount()).toBe(0);
    for (const s of sheets) expect(status(s.contentKey)?.status).toBe("pending");
  });

  it("a missing binary queues everything without throwing", async () => {
    const r = await run(sheets, {
      config: { ...config, worker: { binary: join(fakeDir, "does-not-exist") } },
    });
    expect(r).toMatchObject({ described: 0, queued: sheets.length });
  });

  it("a crashing worker or output without structured_output leaves the functions pending", async () => {
    for (const mode of ["crash", "nostructured"]) {
      fake.configure({ mode });
      const r = await run(sheets);
      expect(r).toMatchObject({ described: 0, failed: 0, queued: sheets.length });
      for (const s of sheets) expect(status(s.contentKey)?.status).toBe("pending");
    }
    expect(descCount()).toBe(0);
    expect(usage()).toHaveLength(2); // the runs are still logged, without tokens
    expect(usage()[0]?.input_tokens).toBeNull();
  });

  it("invalid or missing output counts an attempt and records a reason (pending after the first)", async () => {
    fake.configure({ mode: "invalid" });
    const r = await run(sheets.slice(0, 3));
    expect(r).toMatchObject({ described: 0, failed: 3, queued: 0 });
    const s = status(sheets[0]?.contentKey as string);
    expect(s).toMatchObject({ status: "pending", attempts: 1 });
    expect(s?.last_error).toMatch(/^(injection|shape|identifier|schema)/);
    fake.configure({ mode: "missing" });
    const m = await run(sheets.slice(3, 4));
    expect(m.failed).toBe(1);
    expect(status(sheets[3]?.contentKey as string)?.last_error).toMatch(/missing/);
  });

  it("never sends a sensitive path to the worker", async () => {
    const secret: FactSheet = {
      ...(sheets[0] as FactSheet),
      contentKey: "sens:p1",
      id: "sym:config/.env.local#x",
      path: "config/.env.local",
    };
    const r = await run([secret, ...sheets.slice(0, 2)]);
    expect(r.described).toBe(2);
    expect(fake.runCalls()[0]?.keys).not.toContain("sens:p1");
  });

  it("kills the child at the deadline, queues the rest and returns within budget + 500 ms", async () => {
    fake.configure({ mode: "hang" });
    const t0 = Date.now();
    const r = await run(sheets, { deadlineMs: 700 });
    const ms = Date.now() - t0;
    expect(ms).toBeLessThan(700 + 500);
    expect(r).toMatchObject({ described: 0, queued: sheets.length });
    for (const s of sheets) expect(status(s.contentKey)?.status).toBe("pending");
    // the whole process group is gone, not only the direct child
    const pid = fake.grandchildPid();
    expect(pid).toBeGreaterThan(0);
    await new Promise((res) => setTimeout(res, 100));
    expect(() => process.kill(pid as number, 0)).toThrow();
    expect(usage()).toHaveLength(1);
  });

  it("keeps the batches that finished before the deadline and queues the rest", async () => {
    fake.configure({ delayMs: 800 });
    const r = await run(sheets, { deadlineMs: 2000, batchSize: 2 });
    // batch 1 ends at about 800 ms (over a second of slack for process start under load), batch 3 is always cut
    expect(r.described).toBeGreaterThanOrEqual(2);
    expect(r.described).toBeLessThan(sheets.length);
    expect(r.described + r.queued).toBe(sheets.length);
    expect(descCount()).toBe(r.described);
  });

  it("does not start a call when the deadline has already passed", async () => {
    const r = await run(sheets, { deadlineMs: 0 });
    expect(r.queued).toBe(sheets.length);
    expect(fake.calls()).toHaveLength(0);
  });

  it("does not start a call that cannot finish when the batch size is derived from the time left", async () => {
    const r = await run(sheets, { deadlineMs: 2000, batchSize: undefined });
    expect(r.queued).toBe(sheets.length);
    expect(fake.runCalls()).toHaveLength(0);
  });
});

describe("describeWithRetry", () => {
  it("re-runs functions that fail the checks once on the describe.retry route (Sonnet)", async () => {
    fake.configure({ mode: "invalid", perModel: { sonnet: "valid" } });
    const list = sheets.slice(0, 3);
    const r = await describeWithRetry(ix.store, list, {
      task: "describe.precommit",
      deadlineMs: 20_000,
      config,
      env: { ...process.env },
      batchSize: 40,
    });
    expect(r).toMatchObject({ described: 3, failed: 0 });
    expect(fake.runCalls().map((c) => c.model)).toEqual(["haiku", "sonnet"]);
    expect(fake.runCalls().map((c) => c.effort)).toEqual(["low", "low"]);
    const tasks = usage().map((u) => [u.task, u.model]);
    expect(tasks).toEqual([
      ["describe.precommit", "haiku"],
      ["describe.retry", "sonnet"],
    ]);
    expect(
      ix.store.db
        .prepare("SELECT model, provenance FROM descriptions WHERE provenance = 'model' LIMIT 1")
        .get(),
    ).toEqual({
      model: "sonnet",
      provenance: "model",
    });
  });

  it("a function that fails both routes stays failed after two attempts and is not tried a third time", async () => {
    fake.configure({ mode: "invalid" });
    const list = sheets.slice(0, 2);
    const o = {
      task: "describe.precommit" as const,
      deadlineMs: 20_000,
      config,
      env: { ...process.env },
      batchSize: 40,
    };
    const r = await describeWithRetry(ix.store, list, o);
    expect(r).toMatchObject({ described: 0, failed: 2 });
    expect(status(list[0]?.contentKey as string)).toMatchObject({ status: "failed", attempts: 2 });
    const before = fake.runCalls().length;
    await describeWithRetry(ix.store, list, o);
    expect(fake.runCalls()).toHaveLength(before);
  });

  it("skips the retry pass when no time is left", async () => {
    fake.configure({ mode: "invalid", delayMs: 300 });
    const r = await describeWithRetry(ix.store, sheets.slice(0, 2), {
      task: "describe.precommit",
      deadlineMs: 400,
      config,
      env: { ...process.env },
      batchSize: 40,
    });
    expect(r.described).toBe(0);
    // Under load the first call may not start at all; what matters is that the retry model is never called.
    const models = fake.runCalls().map((c) => c.model);
    expect(models).not.toContain("sonnet");
    expect(models.length).toBeLessThanOrEqual(1);
  });

  it("a function is tried at most MAX_DESCRIBE_ATTEMPTS times in total across the worker and the MCP submit path", async () => {
    expect(MAX_DESCRIBE_ATTEMPTS).toBe(2);
    const target = sheets[0] as FactSheet;
    const o = {
      task: "describe.precommit" as const,
      deadlineMs: 20_000,
      config,
      env: { ...process.env },
      batchSize: 40,
    };
    // attempt 1: the worker fails it (pending, attempts 1)
    fake.configure({ mode: "invalid", perModel: { sonnet: "valid" } });
    await describeWithWorker(ix.store, [target], o);
    expect(status(target.contentKey)).toMatchObject({ status: "pending", attempts: 1 });
    // attempt 2: a describer claims it and submits a bad description through the MCP path -> parked as failed
    const { batchId, items } = claimBatch(ix.store, "w1", 40);
    expect(items.map((i) => i.contentKey)).toContain(target.contentKey);
    const r = submitDescriptions(ix.store, batchId, [
      { contentKey: target.contentKey, description: { behavior: "" } },
    ]);
    expect(r.rejected).toHaveLength(1);
    expect(status(target.contentKey)).toMatchObject({ status: "failed", attempts: 2 });
    // the hook path must not try it a third time, on any route
    const before = fake.runCalls().length;
    const res = await describeWithRetry(ix.store, [target], o);
    expect(fake.runCalls()).toHaveLength(before);
    expect(res).toMatchObject({ described: 0, failed: 0 });
  });
});

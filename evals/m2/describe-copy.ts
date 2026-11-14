/**
 * Describes the whole backlog of an indexed eval copy with the headless worker (spec section 16), four calls at a
 * time, and prints aggregate counts only. Model calls: Haiku/low by the `describe.sync` route. Usage is recorded
 * in the copy's usage_log (see `gantry usage`).
 *
 * Usage: CLAUDE_PLUGIN_DATA=<dir> pnpm tsx evals/m2/describe-copy.ts <repo-copy> [--max-batches n]
 * Needs `gantry init` to have been run on the copy. Reads the copy, never writes to it.
 */
import { resolve } from "node:path";
import {
  BATCH_SIZE,
  backlogCounts,
  claimBatch,
  describeWithWorker,
  loadConfig,
  openStore,
  resolvePaths,
  syncBacklog,
} from "../../packages/core/src/index.js";
import { requireDataDir } from "./safety.js";

const repo = resolve(process.argv[2] ?? "");
requireDataDir();
const maxArg = process.argv.indexOf("--max-batches");
const maxBatches = maxArg >= 0 ? Number(process.argv[maxArg + 1]) : Number.POSITIVE_INFINITY;
const paths = resolvePaths(repo);
const store = openStore(paths.dbPath);
const config = loadConfig(paths);
const sync = syncBacklog(store, { root: paths.root });
process.stderr.write(`enqueued ${sync.enqueued}, templated ${sync.templated}\n`);

let batches = 0;
let described = 0;
let failed = 0;
let inTok = 0;
let outTok = 0;
const t0 = Date.now();
async function lane(id: number): Promise<void> {
  for (;;) {
    if (batches >= maxBatches) return;
    batches++;
    const { items } = claimBatch(store, `eval-${id}`, BATCH_SIZE, { root: paths.root });
    if (items.length === 0) return;
    const r = await describeWithWorker(store, items, {
      task: "describe.sync",
      deadlineMs: 10 * 60 * 1000,
      config,
      batchSize: BATCH_SIZE,
    });
    described += r.described;
    failed += r.failed;
    inTok += r.inputTokens;
    outTok += r.outputTokens;
    process.stderr.write(`lane ${id}: batch done, described so far ${described}, failed ${failed}\n`);
  }
}
await Promise.all([0, 1, 2, 3].map(lane));
const c = backlogCounts(store);
process.stdout.write(
  `${JSON.stringify({ described, failed, inTok, outTok, seconds: Math.round((Date.now() - t0) / 1000), backlog: c })}\n`,
);
store.close();

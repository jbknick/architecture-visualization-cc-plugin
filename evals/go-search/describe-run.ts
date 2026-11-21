/**
 * Agent part of #224 (never run by `pnpm check`): copies `fixtures/go-basic` to a temp repo, runs `gantry init`
 * with the built CLI, describes every function with the real headless worker (`describe.sync` route, local Claude
 * Code login), then scores the 10 behaviour queries of `queries.json` with keywords only (no vectors).
 * Prints `{ model, modelId, described, failed, top5 }` (`modelId` is the id the alias resolved to) as one JSON line on stdout (details on stderr).
 *
 * Usage: pnpm build && pnpm tsx evals/go-search/describe-run.ts --model haiku
 * `--model` is the route alias (haiku, sonnet or opus) the worker passes to `claude -p`; without it the configured
 * `describe.sync` model is used. Model calls: one headless call per batch of up to 10 functions of a 14-function fixture.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BATCH_SIZE,
  backlogCounts,
  claimBatch,
  describeWithWorker,
  hybridSearch,
  loadConfig,
  openStore,
  resolvePaths,
  syncBacklog,
} from "../../packages/core/src/index.js";
import { materializeFixture } from "../../packages/core/test/helpers/fixture.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "../..");
const MODELS = ["haiku", "sonnet", "opus"] as const;
type Model = (typeof MODELS)[number];

const arg = process.argv.indexOf("--model");
const asked = arg >= 0 ? process.argv[arg + 1] : undefined;
if (asked !== undefined && !(MODELS as readonly string[]).includes(asked)) {
  process.stderr.write(`--model must be one of ${MODELS.join(", ")}\n`);
  process.exit(2);
}

const data = mkdtempSync(join(tmpdir(), "gantry-go-search-data-"));
// No model files: no vectors, so the score is the keyword half of hybrid search only.
const emptyModels = mkdtempSync(join(tmpdir(), "gantry-go-search-models-"));
process.env.GANTRY_MODELS_DIR = emptyModels;
const env = { ...process.env, CLAUDE_PLUGIN_DATA: data };
const fx = await materializeFixture("go-basic");
try {
  const init = spawnSync(process.execPath, [join(root, "plugin/dist/cli.js"), "init"], {
    cwd: fx.dir,
    env,
    encoding: "utf8",
  });
  if (init.status !== 0) throw new Error(`gantry init failed (run pnpm build first): ${init.stderr}`);

  const paths = resolvePaths(fx.dir, env);
  const store = openStore(paths.dbPath);
  const config = loadConfig(paths);
  if (asked !== undefined) config.routing["describe.sync"].model = asked as Model;
  const model = config.routing["describe.sync"].model;

  const sync = syncBacklog(store, { root: paths.root });
  process.stderr.write(`enqueued ${sync.enqueued}, templated ${sync.templated}\n`);
  let described = 0;
  let failed = 0;
  // The model ids the worker's calls report (`modelUsage` of `claude -p --output-format json`): what the alias resolved to.
  const resolved = new Set<string>();
  for (;;) {
    const { items } = claimBatch(store, "go-search", BATCH_SIZE, { root: paths.root });
    if (items.length === 0) break;
    const r = await describeWithWorker(store, items, {
      task: "describe.sync",
      deadlineMs: 10 * 60 * 1000,
      config,
      batchSize: BATCH_SIZE,
    });
    described += r.described;
    failed += r.failed;
    for (const m of r.models ?? []) resolved.add(m);
    process.stderr.write(`batch done: described ${described}, failed ${failed}, queued ${r.queued}\n`);
  }
  // Functions the worker could not describe (still in the backlog, failed or not) count as failed.
  // `failed` is the number of functions with no model description at the end, not the count of rejected attempts.
  const attempts = failed;
  failed = backlogCounts(store).total;
  process.stderr.write(`rejected attempts ${attempts}, functions left undescribed ${failed}\n`);
  for (const row of store.db.prepare("SELECT symbol_id, status, attempts, last_error FROM backlog").all())
    process.stderr.write(`left in backlog: ${JSON.stringify(row)}\n`);

  const queries = JSON.parse(readFileSync(join(here, "queries.json"), "utf8")) as {
    q: string;
    expected: string;
  }[];
  const repo = store.repo();
  let top5 = 0;
  for (const { q, expected } of queries) {
    const hits = await hybridSearch(store, q, { lang: "go", limit: 5 });
    const hit = hits.some((h) => h.id === `sym:${repo}:${expected}`);
    if (hit) top5++;
    else {
      process.stderr.write(`missed: ${q} -> ${hits.map((h) => h.name).join(", ")}\n`);
      // Cause of a miss: the description written for the expected function and its rank in a longer list.
      const wide = await hybridSearch(store, q, { lang: "go", limit: 30 });
      const rank = wide.findIndex((h) => h.id === `sym:${repo}:${expected}`);
      const sym = store.getSymbol(`sym:${repo}:${expected}`);
      const row = sym
        ? store.db
            .prepare("SELECT behavior, search_terms FROM descriptions WHERE content_key LIKE ?")
            .get(`${sym.exactHash}:%`)
        : undefined;
      process.stderr.write(
        `  expected ${expected} at rank ${rank < 0 ? "none of 30" : rank + 1}; description: ${JSON.stringify(row)}\n`,
      );
    }
  }
  const modelId = resolved.size > 0 ? [...resolved].sort().join(",") : "unknown";
  process.stdout.write(`${JSON.stringify({ model, modelId, described, failed, top5 })}\n`);
  store.close();
} finally {
  await fx.cleanup();
  rmSync(data, { recursive: true, force: true });
  rmSync(emptyModels, { recursive: true, force: true });
}

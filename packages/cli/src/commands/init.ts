import fs from "node:fs";
import {
  BATCH_SIZE,
  BATCHES_PER_ROUND,
  type Estimate,
  estimate,
  type GantryPaths,
  heal,
  indexCounts,
  indexRepo,
  loadConfig,
  openStore,
  reattachOverlay,
  rebuildSimilarEdges,
  resetStaleStore,
  SECONDS_PER_FUNCTION_SEQUENTIAL,
  syncBacklog,
  syncTeamDescriptions,
  writeCatalog,
} from "@gantry/core";
import type { Command } from "commander";
import { runEmbed, summaryOf } from "./embed.js";
import { EXIT_OK, fail, recipeLines, resolveCliPaths, summaryLines, WORKSPACE_FLAG } from "./shared.js";

/** The same bounds as the MCP server's start-up sync. */
const INIT_SYNC_LIMIT = 2000;
const INIT_SYNC_TIMEOUT_MS = 5000;

const nf = new Intl.NumberFormat("en-US");

/** Estimate block printed by `gantry init --estimate` (spec section 10); no model is ever called. */
export function estimateLines(e: Estimate, exportsFirst: boolean): string[] {
  const minutes = (e.toDescribe * SECONDS_PER_FUNCTION_SEQUENTIAL) / 60;
  const time = minutes > 0 && minutes < 1 ? "<1" : nf.format(Math.round(minutes));
  return [
    `Description estimate${exportsFirst ? " (exported and entry-file functions only)" : ""}, no model calls made:`,
    `  function-like:  ${nf.format(e.functionLike)}`,
    `  templated:      ${nf.format(e.templated)}`,
    `  to describe:    ${nf.format(e.toDescribe)}`,
    `  input tokens:   ${nf.format(e.inputTokens)}`,
    `  output tokens:  ${nf.format(e.outputTokens)}`,
    `  batches:        ${nf.format(e.batches)} (${BATCH_SIZE} functions each)`,
    `  rounds:         ${nf.format(e.rounds)} (${BATCHES_PER_ROUND} batches each)`,
    `  sequential headless time: about ${time} min (${SECONDS_PER_FUNCTION_SEQUENTIAL} s per function, measured in M0)`,
  ];
}

export function noteFreshIndex(paths: GantryPaths): void {
  if (fs.existsSync(paths.dbPath)) return;
  process.stderr.write(`gantry: no index for this repository in ${paths.dataDir}; building a fresh one\n`);
}

/**
 * Before the backlog is built, fills in the descriptions the team already has (spec section 11, "Description sync"), so
 * the describer is only handed what nobody has described. Best effort and bounded like the MCP start-up sync: with no
 * team, no sign-in or an unreachable server it does nothing, and a failure is one line on stderr, never an error.
 */
export async function syncTeamDescriptionsBeforeBacklog(
  paths: GantryPaths,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  try {
    const outcome = await syncTeamDescriptions(paths, loadConfig(paths), {
      env,
      limit: INIT_SYNC_LIMIT,
      timeoutMs: INIT_SYNC_TIMEOUT_MS,
      log: (line) => process.stderr.write(`gantry: ${line}\n`),
    });
    if (outcome.status === "done" && outcome.filled > 0) {
      process.stderr.write(`gantry: filled ${outcome.filled} descriptions from the team\n`);
    }
  } catch (err) {
    process.stderr.write(
      `gantry: description sync skipped: ${err instanceof Error ? err.message : String(err)}\n`,
    );
  }
}

/** `gantry init` after the paths are known: index, heal, team descriptions, backlog, catalog. */
export async function initRepo(
  paths: GantryPaths,
  opts: { estimate?: boolean; exportsFirst?: boolean; embed?: boolean },
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  resetStaleStore(paths);
  noteFreshIndex(paths);
  const r = await indexRepo(paths, { layer: "main" });
  for (const line of recipeLines(r)) process.stderr.write(`${line}\n`);
  await heal(paths);
  await syncTeamDescriptionsBeforeBacklog(paths, env);
  const store = openStore(paths.dbPath, { overlayPath: paths.overlayPath, repo: paths.repo });
  try {
    reattachOverlay(store);
    syncBacklog(store, { root: paths.root });
    writeCatalog(store, paths);
    await rebuildSimilarEdges(store);
    // Totals of the finished index, read the way `/api/meta` and the estimate read them (spec section 10).
    const totals = { ...r, ...indexCounts(store) };
    for (const line of summaryLines(totals, paths.dataDir)) process.stdout.write(`${line}\n`);
    if (opts.estimate) {
      const exportsFirst = opts.exportsFirst === true;
      for (const line of estimateLines(estimate(store, { exportsFirst }), exportsFirst)) {
        process.stdout.write(`${line}\n`);
      }
    } else if (opts.embed) {
      // Explicit opt-in: init never embeds on its own (it is deterministic and fast; spec section 11).
      // Never fatal: a missing model leaves the index as it is.
      try {
        const e = await runEmbed(store, paths.root);
        for (const line of summaryOf(e)) process.stdout.write(`${line}\n`);
      } catch (e) {
        process.stderr.write(`gantry: embedding skipped: ${e instanceof Error ? e.message : String(e)}\n`);
      }
    }
  } finally {
    store.close();
  }
}

export function registerInit(program: Command): void {
  program
    .command("init")
    .description("Create the data directory and run a full deterministic index of the current repo")
    .option("--estimate", "print function counts and the projected description cost; no model calls")
    .option(
      "--exports-first",
      "with --estimate, count only priority 0-1 functions (exported and entry files)",
    )
    .option(
      "--embed",
      "after indexing, also embed code and descriptions (slow on a large repo; see `gantry embed`)",
    )
    .option(...WORKSPACE_FLAG)
    .action(
      async (opts: { estimate?: boolean; exportsFirst?: boolean; embed?: boolean; workspace?: string }) => {
        try {
          await initRepo(resolveCliPaths(opts), opts);
          process.exitCode = EXIT_OK;
        } catch (err) {
          process.exitCode = fail(err);
        }
      },
    );
}

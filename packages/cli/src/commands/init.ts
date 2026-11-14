import {
  BATCH_SIZE,
  BATCHES_PER_ROUND,
  type Estimate,
  estimate,
  heal,
  indexRepo,
  openStore,
  resolvePaths,
  SECONDS_PER_FUNCTION_SEQUENTIAL,
  syncBacklog,
} from "@gantry/core";
import type { Command } from "commander";
import { runEmbed, summaryOf } from "./embed.js";
import { EXIT_OK, fail, summaryLines } from "./shared.js";

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
    .action(async (opts: { estimate?: boolean; exportsFirst?: boolean; embed?: boolean }) => {
      try {
        const paths = resolvePaths(process.cwd());
        const r = await indexRepo(paths, { layer: "main" });
        await heal(paths);
        const store = openStore(paths.dbPath);
        try {
          syncBacklog(store, { root: paths.root });
          for (const line of summaryLines(r, paths.dataDir)) process.stdout.write(`${line}\n`);
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
              process.stderr.write(
                `gantry: embedding skipped: ${e instanceof Error ? e.message : String(e)}\n`,
              );
            }
          }
        } finally {
          store.close();
        }
        process.exitCode = EXIT_OK;
      } catch (err) {
        process.exitCode = fail(err);
      }
    });
}

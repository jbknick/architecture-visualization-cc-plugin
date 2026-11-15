import {
  formatImpact,
  parseRange,
  resolvePaths,
  resolvePullRequest,
  reviewDiff,
  reviewImpact,
} from "@gantry/core";
import type { Command } from "commander";
import { openFresh } from "./lookup.js";
import { EXIT_ERROR, EXIT_OK, fail, writeStdout } from "./shared.js";

export function registerReview(program: Command): void {
  program
    .command("review [range]")
    .description(
      "Symbol-level diff between git refs (<base>...<head> or --pr <n>); --json prints the diff, otherwise a short impact and risk summary",
    )
    .option("--pr <n>", "review a pull request (needs gh); fetches its refs if missing")
    .option("--json", "print the diff as JSON on stdout (read from git, no re-indexing)")
    .action(async (range: string | undefined, opts: { pr?: string; json?: boolean }) => {
      try {
        if ((range === undefined) === (opts.pr === undefined)) {
          process.stderr.write("gantry: give either <base>...<head> or --pr <n>\n");
          process.exitCode = EXIT_ERROR;
          return;
        }
        const paths = resolvePaths(process.cwd());
        const refs = range !== undefined ? parseRange(range) : resolvePullRequest(paths, Number(opts.pr));
        if (opts.json) {
          const diff = await reviewDiff(paths, refs.base, refs.head);
          writeStdout(`${JSON.stringify(diff, null, 2)}\n`);
        } else {
          // The text summary walks the graph, so it brings the index to HEAD and the tree first.
          const { store } = await openFresh(process.cwd());
          try {
            const diff = await reviewDiff(paths, refs.base, refs.head);
            writeStdout(formatImpact(diff, await reviewImpact(paths, store, diff)));
          } finally {
            store.close();
          }
        }
        process.exitCode = EXIT_OK;
      } catch (err) {
        process.exitCode = fail(err);
      }
    });
}

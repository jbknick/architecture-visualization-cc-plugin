import { parseRange, resolvePaths, resolvePullRequest, reviewDiff } from "@gantry/core";
import type { Command } from "commander";
import { EXIT_ERROR, EXIT_OK, fail, writeStdout } from "./shared.js";

export function registerReview(program: Command): void {
  program
    .command("review [range]")
    .description(
      "Symbol-level diff between git refs (<base>...<head> or --pr <n>), read from git without re-indexing",
    )
    .option("--pr <n>", "review a pull request (needs gh); fetches its refs if missing")
    .option("--json", "print the diff as JSON on stdout")
    .action(async (range: string | undefined, opts: { pr?: string; json?: boolean }) => {
      try {
        if ((range === undefined) === (opts.pr === undefined)) {
          process.stderr.write("gantry: give either <base>...<head> or --pr <n>\n");
          process.exitCode = EXIT_ERROR;
          return;
        }
        if (!opts.json) {
          process.stderr.write("gantry: only --json output exists so far; add --json\n");
          process.exitCode = EXIT_ERROR;
          return;
        }
        const paths = resolvePaths(process.cwd());
        const refs = range !== undefined ? parseRange(range) : resolvePullRequest(paths, Number(opts.pr));
        const diff = await reviewDiff(paths, refs.base, refs.head);
        writeStdout(`${JSON.stringify(diff, null, 2)}\n`);
        process.exitCode = EXIT_OK;
      } catch (err) {
        process.exitCode = fail(err);
      }
    });
}

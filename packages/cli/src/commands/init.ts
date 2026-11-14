import { indexRepo, resolvePaths } from "@gantry/core";
import type { Command } from "commander";
import { EXIT_OK, fail, summaryLines } from "./shared.js";

export function registerInit(program: Command): void {
  program
    .command("init")
    .description("Create the data directory and run a full deterministic index of the current repo")
    .option("--estimate", "print counts only; no model calls (token projection arrives in M2)")
    .option("--exports-first", "accepted for forward compatibility; has no effect in M1")
    .action(async (opts: { estimate?: boolean }) => {
      try {
        const paths = resolvePaths(process.cwd());
        const r = await indexRepo(paths, { layer: "main" });
        for (const line of summaryLines(r, paths.dataDir)) process.stdout.write(`${line}\n`);
        if (opts.estimate) process.stdout.write("Descriptions not estimated until M2\n");
        process.exitCode = EXIT_OK;
      } catch (err) {
        process.exitCode = fail(err);
      }
    });
}
